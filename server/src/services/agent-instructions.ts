import fs from "node:fs/promises";
import { constants as fsConstants, type BigIntStats } from "node:fs";
import path from "node:path";
import { notFound, unprocessable } from "../errors.js";
import { resolveHomeAwarePath, resolvePaperclipInstanceRoot } from "../home-paths.js";
import {
  assertHistoricalAgentTombstoneMutable,
  isHistoricalAgentTombstoneId,
} from "./agent-retirement-historical-tombstones.js";

const ENTRY_FILE_DEFAULT = "AGENTS.md";
const MODE_KEY = "instructionsBundleMode";
const ROOT_KEY = "instructionsRootPath";
const ENTRY_KEY = "instructionsEntryFile";
const FILE_KEY = "instructionsFilePath";
const PROMPT_KEY = "promptTemplate";
/** @deprecated Use the managed instructions bundle system instead. */
const BOOTSTRAP_PROMPT_KEY = "bootstrapPromptTemplate";
const LEGACY_PROMPT_TEMPLATE_PATH = "promptTemplate.legacy.md";
const IGNORED_INSTRUCTIONS_FILE_NAMES = new Set([".DS_Store", "Thumbs.db", "Desktop.ini"]);
const IGNORED_INSTRUCTIONS_DIRECTORY_NAMES = new Set([
  ".git",
  ".nox",
  ".pytest_cache",
  ".ruff_cache",
  ".tox",
  ".venv",
  "__pycache__",
  "node_modules",
  "venv",
]);

const READ_ONLY_EXPORT_DEFAULT_LIMITS = {
  maxFiles: 256,
  maxDirectories: 128,
  maxDepth: 16,
  maxFileBytes: 1024 * 1024,
  maxTotalBytes: 4 * 1024 * 1024,
} as const;

type ReadOnlyExportOptions = {
  signal?: AbortSignal;
  maxFiles?: number;
  maxDirectories?: number;
  maxDepth?: number;
  maxFileBytes?: number;
  maxTotalBytes?: number;
};

type ResolvedReadOnlyExportOptions = Required<Omit<ReadOnlyExportOptions, "signal">> & {
  signal?: AbortSignal;
};

type ReadOnlyDirectoryIdentity = {
  absolutePath: string;
  canonicalPath: string;
  relativePath: string;
  dev: bigint;
  ino: bigint;
};

type ReadOnlyBundleScan = {
  absoluteRoot: string;
  canonicalRoot: string;
  directories: ReadOnlyDirectoryIdentity[];
  relativePaths: string[];
};

type BundleMode = "managed" | "external";

type AgentLike = {
  id: string;
  companyId: string;
  name: string;
  adapterConfig: unknown;
};

type AgentInstructionsServiceOptions = {
  /** Deterministic race injection for filesystem boundary tests. */
  beforeReadOnlyFileOpen?: (absolutePath: string) => Promise<void>;
};

type AgentInstructionsFileSummary = {
  path: string;
  size: number;
  language: string;
  markdown: boolean;
  isEntryFile: boolean;
  editable: boolean;
  deprecated: boolean;
  virtual: boolean;
};

type AgentInstructionsFileDetail = AgentInstructionsFileSummary & {
  content: string;
  editable: boolean;
};

type AgentInstructionsBundle = {
  agentId: string;
  companyId: string;
  mode: BundleMode | null;
  rootPath: string | null;
  managedRootPath: string;
  entryFile: string;
  resolvedEntryPath: string | null;
  editable: boolean;
  warnings: string[];
  legacyPromptTemplateActive: boolean;
  legacyBootstrapPromptTemplateActive: boolean;
  files: AgentInstructionsFileSummary[];
};

type BundleState = {
  config: Record<string, unknown>;
  mode: BundleMode | null;
  rootPath: string | null;
  entryFile: string;
  resolvedEntryPath: string | null;
  warnings: string[];
  legacyPromptTemplateActive: boolean;
  legacyBootstrapPromptTemplateActive: boolean;
};

function asRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  return value as Record<string, unknown>;
}

function asString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function isBundleMode(value: unknown): value is BundleMode {
  return value === "managed" || value === "external";
}

function inferLanguage(relativePath: string): string {
  const lower = relativePath.toLowerCase();
  if (lower.endsWith(".md")) return "markdown";
  if (lower.endsWith(".json")) return "json";
  if (lower.endsWith(".yaml") || lower.endsWith(".yml")) return "yaml";
  if (lower.endsWith(".ts") || lower.endsWith(".tsx")) return "typescript";
  if (lower.endsWith(".js") || lower.endsWith(".jsx") || lower.endsWith(".mjs") || lower.endsWith(".cjs")) {
    return "javascript";
  }
  if (lower.endsWith(".sh")) return "bash";
  if (lower.endsWith(".py")) return "python";
  if (lower.endsWith(".toml")) return "toml";
  if (lower.endsWith(".txt")) return "text";
  return "text";
}

function isMarkdown(relativePath: string) {
  return relativePath.toLowerCase().endsWith(".md");
}

function normalizeRelativeFilePath(candidatePath: string): string {
  const normalized = path.posix.normalize(candidatePath.replaceAll("\\", "/")).replace(/^\/+/, "");
  if (!normalized || normalized === "." || normalized === ".." || normalized.startsWith("../")) {
    throw unprocessable("Instructions file path must stay within the bundle root");
  }
  return normalized;
}

function resolvePathWithinRoot(rootPath: string, relativePath: string): string {
  const normalizedRelativePath = normalizeRelativeFilePath(relativePath);
  const absoluteRoot = path.resolve(rootPath);
  const absolutePath = path.resolve(absoluteRoot, normalizedRelativePath);
  const relativeToRoot = path.relative(absoluteRoot, absolutePath);
  if (relativeToRoot === ".." || relativeToRoot.startsWith(`..${path.sep}`)) {
    throw unprocessable("Instructions file path must stay within the bundle root");
  }
  return absolutePath;
}

function resolveManagedInstructionsRoot(agent: AgentLike): string {
  return path.resolve(
    resolvePaperclipInstanceRoot(),
    "companies",
    agent.companyId,
    "agents",
    agent.id,
    "instructions",
  );
}

function resolveLegacyInstructionsPath(candidatePath: string, config: Record<string, unknown>): string {
  if (path.isAbsolute(candidatePath)) return candidatePath;
  const cwd = asString(config.cwd);
  if (!cwd || !path.isAbsolute(cwd)) {
    throw unprocessable(
      "Legacy relative instructionsFilePath requires adapterConfig.cwd to be set to an absolute path",
    );
  }
  return path.resolve(cwd, candidatePath);
}

async function statIfExists(targetPath: string) {
  return fs.stat(targetPath).catch(() => null);
}

function filesystemErrorCode(error: unknown): string | null {
  if (!error || typeof error !== "object") return null;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : null;
}

async function lstatIfExistsStrict(targetPath: string): Promise<BigIntStats | null> {
  try {
    return await fs.lstat(targetPath, { bigint: true });
  } catch (error) {
    if (filesystemErrorCode(error) === "ENOENT") return null;
    throw error;
  }
}

function shouldIgnoreInstructionsEntry(entry: { name: string; isDirectory(): boolean; isFile(): boolean }) {
  if (entry.name === "." || entry.name === "..") return true;
  if (entry.isDirectory()) {
    return IGNORED_INSTRUCTIONS_DIRECTORY_NAMES.has(entry.name);
  }
  if (!entry.isFile()) return false;
  return (
    IGNORED_INSTRUCTIONS_FILE_NAMES.has(entry.name)
    || entry.name.startsWith("._")
    || entry.name.endsWith(".pyc")
    || entry.name.endsWith(".pyo")
  );
}

async function listFilesRecursive(rootPath: string): Promise<string[]> {
  const output: string[] = [];

  async function walk(currentPath: string, relativeDir: string) {
    const entries = await fs.readdir(currentPath, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (shouldIgnoreInstructionsEntry(entry)) continue;
      const absolutePath = path.join(currentPath, entry.name);
      const relativePath = normalizeRelativeFilePath(
        relativeDir ? path.posix.join(relativeDir, entry.name) : entry.name,
      );
      if (entry.isDirectory()) {
        await walk(absolutePath, relativePath);
        continue;
      }
      if (!entry.isFile()) continue;
      output.push(relativePath);
    }
  }

  await walk(rootPath, "");
  return output.sort((left, right) => left.localeCompare(right));
}

function resolveReadOnlyExportOptions(options: ReadOnlyExportOptions = {}): ResolvedReadOnlyExportOptions {
  const positiveBound = (value: number | undefined, fallback: number) =>
    Number.isFinite(value) ? Math.max(1, Math.floor(value!)) : fallback;
  return {
    signal: options.signal,
    maxFiles: positiveBound(options.maxFiles, READ_ONLY_EXPORT_DEFAULT_LIMITS.maxFiles),
    maxDirectories: positiveBound(options.maxDirectories, READ_ONLY_EXPORT_DEFAULT_LIMITS.maxDirectories),
    maxDepth: positiveBound(options.maxDepth, READ_ONLY_EXPORT_DEFAULT_LIMITS.maxDepth),
    maxFileBytes: positiveBound(options.maxFileBytes, READ_ONLY_EXPORT_DEFAULT_LIMITS.maxFileBytes),
    maxTotalBytes: positiveBound(options.maxTotalBytes, READ_ONLY_EXPORT_DEFAULT_LIMITS.maxTotalBytes),
  };
}

function assertReadOnlyExportNotAborted(signal?: AbortSignal) {
  if (signal?.aborted) throw new Error("agent_instructions_read_aborted");
}

async function listFilesRecursiveBounded(
  rootPath: string,
  options: ResolvedReadOnlyExportOptions,
): Promise<string[]> {
  return (await scanReadOnlyBundleRoot(rootPath, options)).relativePaths;
}

function sameFilesystemObject(
  left: Pick<BigIntStats, "dev" | "ino">,
  right: Pick<BigIntStats, "dev" | "ino">,
) {
  return left.dev === right.dev && left.ino === right.ino;
}

function sameStableFile(
  left: Pick<BigIntStats, "dev" | "ino" | "size" | "mtimeNs" | "ctimeNs">,
  right: Pick<BigIntStats, "dev" | "ino" | "size" | "mtimeNs" | "ctimeNs">,
) {
  return sameFilesystemObject(left, right)
    && left.size === right.size
    && left.mtimeNs === right.mtimeNs
    && left.ctimeNs === right.ctimeNs;
}

function assertCanonicalPath(rootPath: string, expectedPath: string, actualPath: string) {
  const relativeToRoot = path.relative(rootPath, actualPath);
  if (
    path.isAbsolute(relativeToRoot)
    || relativeToRoot === ".."
    || relativeToRoot.startsWith(`..${path.sep}`)
    || path.resolve(actualPath) !== path.resolve(expectedPath)
  ) {
    throw new Error("agent_instructions_path_boundary_changed");
  }
}

async function assertReadOnlyDirectoryIdentity(
  rootCanonicalPath: string,
  identity: ReadOnlyDirectoryIdentity,
) {
  const current = await lstatIfExistsStrict(identity.absolutePath);
  if (!current || current.isSymbolicLink() || !current.isDirectory()) {
    throw new Error("agent_instructions_directory_changed");
  }
  if (current.dev !== identity.dev || current.ino !== identity.ino) {
    throw new Error("agent_instructions_directory_changed");
  }
  const canonicalPath = await fs.realpath(identity.absolutePath);
  assertCanonicalPath(rootCanonicalPath, identity.canonicalPath, canonicalPath);
}

async function scanReadOnlyBundleRoot(
  rootPath: string,
  options: ResolvedReadOnlyExportOptions,
): Promise<ReadOnlyBundleScan> {
  assertReadOnlyExportNotAborted(options.signal);
  const absoluteRoot = path.resolve(rootPath);
  const rootStat = await lstatIfExistsStrict(absoluteRoot);
  if (!rootStat) throw new Error("agent_instructions_root_missing");
  if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) {
    throw new Error("agent_instructions_root_not_directory");
  }
  const canonicalRoot = await fs.realpath(absoluteRoot);
  const output: string[] = [];
  const directories: ReadOnlyDirectoryIdentity[] = [];

  async function walk(currentPath: string, relativeDir: string, depth: number) {
    assertReadOnlyExportNotAborted(options.signal);
    if (depth > options.maxDepth) throw new Error("agent_instructions_max_depth_exceeded");
    if (directories.length >= options.maxDirectories) {
      throw new Error("agent_instructions_max_directories_exceeded");
    }
    const currentStat = await lstatIfExistsStrict(currentPath);
    if (!currentStat || currentStat.isSymbolicLink() || !currentStat.isDirectory()) {
      throw new Error("agent_instructions_directory_changed");
    }
    const canonicalPath = await fs.realpath(currentPath);
    const expectedCanonicalPath = relativeDir
      ? path.join(canonicalRoot, ...relativeDir.split("/"))
      : canonicalRoot;
    assertCanonicalPath(canonicalRoot, expectedCanonicalPath, canonicalPath);
    const identity: ReadOnlyDirectoryIdentity = {
      absolutePath: currentPath,
      canonicalPath,
      relativePath: relativeDir,
      dev: currentStat.dev,
      ino: currentStat.ino,
    };
    directories.push(identity);

    const entries = await fs.readdir(currentPath, { withFileTypes: true });
    assertReadOnlyExportNotAborted(options.signal);
    await assertReadOnlyDirectoryIdentity(canonicalRoot, identity);
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      assertReadOnlyExportNotAborted(options.signal);
      if (shouldIgnoreInstructionsEntry(entry)) continue;
      const absolutePath = path.join(currentPath, entry.name);
      const relativePath = normalizeRelativeFilePath(
        relativeDir ? path.posix.join(relativeDir, entry.name) : entry.name,
      );
      if (entry.isDirectory()) {
        await walk(absolutePath, relativePath, depth + 1);
        continue;
      }
      if (!entry.isFile()) {
        throw new Error("agent_instructions_unsupported_filesystem_entry");
      }
      output.push(relativePath);
      if (output.length > options.maxFiles) throw new Error("agent_instructions_max_files_exceeded");
    }
    await assertReadOnlyDirectoryIdentity(canonicalRoot, identity);
  }

  await walk(absoluteRoot, "", 0);
  for (const identity of directories) {
    await assertReadOnlyDirectoryIdentity(canonicalRoot, identity);
  }
  return {
    absoluteRoot,
    canonicalRoot,
    directories,
    relativePaths: output.sort((left, right) => left.localeCompare(right)),
  };
}

async function readFileHandleBounded(
  handle: Awaited<ReturnType<typeof fs.open>>,
  limit: number,
  limitError: string,
  signal?: AbortSignal,
) {
  const chunks: Buffer[] = [];
  let position = 0;
  for (;;) {
    assertReadOnlyExportNotAborted(signal);
    const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, Math.max(1, limit - position + 1)));
    const { bytesRead } = await handle.read(chunk, 0, chunk.length, position);
    if (bytesRead === 0) break;
    position += bytesRead;
    if (position > limit) throw new Error(limitError);
    chunks.push(chunk.subarray(0, bytesRead));
  }
  return Buffer.concat(chunks, position);
}

async function secureReadBundleFile(
  scan: ReadOnlyBundleScan,
  relativePath: string,
  options: ResolvedReadOnlyExportOptions,
  remainingTotalBytes: number,
  beforeOpen?: (absolutePath: string) => Promise<void>,
) {
  assertReadOnlyExportNotAborted(options.signal);
  const parentDirectory = path.posix.dirname(relativePath) === "." ? "" : path.posix.dirname(relativePath);
  const ancestorDirectories = scan.directories.filter((identity) =>
    identity.relativePath === ""
    || parentDirectory === identity.relativePath
    || parentDirectory.startsWith(`${identity.relativePath}/`));
  for (const identity of ancestorDirectories) {
    await assertReadOnlyDirectoryIdentity(scan.canonicalRoot, identity);
  }
  const absolutePath = resolvePathWithinRoot(scan.absoluteRoot, relativePath);
  const expectedCanonicalPath = path.join(scan.canonicalRoot, ...relativePath.split("/"));
  const pathBefore = await lstatIfExistsStrict(absolutePath);
  if (!pathBefore || pathBefore.isSymbolicLink() || !pathBefore.isFile()) {
    throw new Error("agent_instructions_file_changed");
  }
  const canonicalBefore = await fs.realpath(absolutePath);
  assertCanonicalPath(scan.canonicalRoot, expectedCanonicalPath, canonicalBefore);
  if (pathBefore.size > BigInt(options.maxFileBytes)) {
    throw new Error("agent_instructions_max_file_bytes_exceeded");
  }
  if (pathBefore.size > BigInt(remainingTotalBytes)) {
    throw new Error("agent_instructions_max_total_bytes_exceeded");
  }

  await beforeOpen?.(absolutePath);
  assertReadOnlyExportNotAborted(options.signal);
  const openFlags = fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0);
  const handle = await fs.open(absolutePath, openFlags);
  try {
    const opened = await handle.stat({ bigint: true });
    if (!opened.isFile() || !sameStableFile(pathBefore, opened)) {
      throw new Error("agent_instructions_file_changed");
    }
    const canonicalOpened = await fs.realpath(absolutePath);
    assertCanonicalPath(scan.canonicalRoot, expectedCanonicalPath, canonicalOpened);
    const pathOpened = await lstatIfExistsStrict(absolutePath);
    if (!pathOpened || pathOpened.isSymbolicLink() || !sameStableFile(opened, pathOpened)) {
      throw new Error("agent_instructions_file_changed");
    }

    const byteLimit = Math.min(options.maxFileBytes, remainingTotalBytes);
    const limitError = remainingTotalBytes < options.maxFileBytes
      ? "agent_instructions_max_total_bytes_exceeded"
      : "agent_instructions_max_file_bytes_exceeded";
    const body = await readFileHandleBounded(handle, byteLimit, limitError, options.signal);
    const openedAfterRead = await handle.stat({ bigint: true });
    const pathAfterRead = await lstatIfExistsStrict(absolutePath);
    if (
      !sameStableFile(opened, openedAfterRead)
      || !pathAfterRead
      || pathAfterRead.isSymbolicLink()
      || !sameStableFile(openedAfterRead, pathAfterRead)
    ) {
      throw new Error("agent_instructions_file_changed");
    }
    const canonicalAfterRead = await fs.realpath(absolutePath);
    assertCanonicalPath(scan.canonicalRoot, expectedCanonicalPath, canonicalAfterRead);
    for (const identity of ancestorDirectories) {
      await assertReadOnlyDirectoryIdentity(scan.canonicalRoot, identity);
    }
    return { content: body.toString("utf8"), bytes: body.byteLength };
  } finally {
    await handle.close();
  }
}

async function readFileSummary(rootPath: string, relativePath: string, entryFile: string): Promise<AgentInstructionsFileSummary> {
  const absolutePath = resolvePathWithinRoot(rootPath, relativePath);
  const stat = await fs.stat(absolutePath);
  return {
    path: relativePath,
    size: stat.size,
    language: inferLanguage(relativePath),
    markdown: isMarkdown(relativePath),
    isEntryFile: relativePath === entryFile,
    editable: true,
    deprecated: false,
    virtual: false,
  };
}

async function readLegacyInstructions(agent: AgentLike, config: Record<string, unknown>): Promise<string> {
  const instructionsFilePath = asString(config[FILE_KEY]);
  if (instructionsFilePath) {
    try {
      const resolvedPath = resolveLegacyInstructionsPath(instructionsFilePath, config);
      return await fs.readFile(resolvedPath, "utf8");
    } catch {
      // Fall back to promptTemplate below.
    }
  }
  return asString(config[PROMPT_KEY]) ?? "";
}

function deriveBundleState(agent: AgentLike): BundleState {
  const config = asRecord(agent.adapterConfig);
  const warnings: string[] = [];
  const storedModeRaw = config[MODE_KEY];
  const storedRootRaw = asString(config[ROOT_KEY]);
  const legacyInstructionsPath = asString(config[FILE_KEY]);

  let mode: BundleMode | null = isBundleMode(storedModeRaw) ? storedModeRaw : null;
  let rootPath = storedRootRaw ? resolveHomeAwarePath(storedRootRaw) : null;
  let entryFile = ENTRY_FILE_DEFAULT;

  const storedEntryRaw = asString(config[ENTRY_KEY]);
  if (storedEntryRaw) {
    try {
      entryFile = normalizeRelativeFilePath(storedEntryRaw);
    } catch {
      warnings.push(`Ignored invalid instructions entry file "${storedEntryRaw}".`);
    }
  }

  if (!rootPath && legacyInstructionsPath) {
    try {
      const resolvedLegacyPath = resolveLegacyInstructionsPath(legacyInstructionsPath, config);
      rootPath = path.dirname(resolvedLegacyPath);
      entryFile = path.basename(resolvedLegacyPath);
      mode = resolvedLegacyPath.startsWith(`${resolveManagedInstructionsRoot(agent)}${path.sep}`)
        || resolvedLegacyPath === path.join(resolveManagedInstructionsRoot(agent), entryFile)
        ? "managed"
        : "external";
      if (!path.isAbsolute(legacyInstructionsPath)) {
        warnings.push("Using legacy relative instructionsFilePath; migrate this agent to a managed or absolute external bundle.");
      }
    } catch (err) {
      warnings.push(err instanceof Error ? err.message : String(err));
    }
  }

  const resolvedEntryPath = rootPath ? path.resolve(rootPath, entryFile) : null;

  return {
    config,
    mode,
    rootPath,
    entryFile,
    resolvedEntryPath,
    warnings,
    legacyPromptTemplateActive: Boolean(asString(config[PROMPT_KEY])),
    legacyBootstrapPromptTemplateActive: Boolean(asString(config[BOOTSTRAP_PROMPT_KEY])),
  };
}

async function recoverManagedBundleState(
  agent: AgentLike,
  state: BundleState,
  listBundleFiles: (rootPath: string) => Promise<string[]> = listFilesRecursive,
  strictReadOnlyFilesystem = false,
): Promise<BundleState> {
  const managedRootPath = resolveManagedInstructionsRoot(agent);
  const stat = strictReadOnlyFilesystem
    ? await lstatIfExistsStrict(managedRootPath)
    : await statIfExists(managedRootPath);
  if (strictReadOnlyFilesystem && stat?.isSymbolicLink()) {
    throw new Error("agent_instructions_root_not_directory");
  }
  const files = stat?.isDirectory() ? await listBundleFiles(managedRootPath) : [];
  const configuredManagedRootMismatch = state.mode === "managed"
    && state.rootPath !== null
    && path.resolve(state.rootPath) !== managedRootPath;
  if (!stat?.isDirectory() || files.length === 0) {
    if (!configuredManagedRootMismatch) return state;
    return {
      ...state,
      rootPath: managedRootPath,
      resolvedEntryPath: path.resolve(managedRootPath, state.entryFile),
      warnings: [
        ...state.warnings,
        `Recovered managed instructions target at ${managedRootPath}; ignoring stale configured root ${state.rootPath}.`,
      ],
    };
  }

  const recoveredEntryFile = files.includes(state.entryFile)
    ? state.entryFile
    : files.includes(ENTRY_FILE_DEFAULT)
      ? ENTRY_FILE_DEFAULT
      : files[0]!;

  if (!state.rootPath) {
    return {
      ...state,
      mode: "managed",
      rootPath: managedRootPath,
      entryFile: recoveredEntryFile,
      resolvedEntryPath: path.resolve(managedRootPath, recoveredEntryFile),
    };
  }

  if (state.mode === "external") return state;

  const resolvedConfiguredRoot = path.resolve(state.rootPath);
  const configuredRootMatchesManaged = resolvedConfiguredRoot === managedRootPath;
  const hasEntryMismatch = recoveredEntryFile !== state.entryFile;

  if (configuredRootMatchesManaged && !hasEntryMismatch) {
    return state;
  }

  const warnings = [...state.warnings];
  if (!configuredRootMatchesManaged) {
    warnings.push(
      `Recovered managed instructions from disk at ${managedRootPath}; ignoring stale configured root ${state.rootPath}.`,
    );
  }
  if (hasEntryMismatch) {
    warnings.push(
      `Recovered managed instructions entry file from disk as ${recoveredEntryFile}; previous entry ${state.entryFile} was missing.`,
    );
  }

  return {
    ...state,
    mode: "managed",
    rootPath: managedRootPath,
    entryFile: recoveredEntryFile,
    resolvedEntryPath: path.resolve(managedRootPath, recoveredEntryFile),
    warnings,
  };
}

function toBundle(agent: AgentLike, state: BundleState, files: AgentInstructionsFileSummary[]): AgentInstructionsBundle {
  const nextFiles = [...files];
  if (state.legacyPromptTemplateActive && !nextFiles.some((file) => file.path === LEGACY_PROMPT_TEMPLATE_PATH)) {
    const legacyPromptTemplate = asString(state.config[PROMPT_KEY]) ?? "";
    nextFiles.push({
      path: LEGACY_PROMPT_TEMPLATE_PATH,
      size: legacyPromptTemplate.length,
      language: "markdown",
      markdown: true,
      isEntryFile: false,
      editable: true,
      deprecated: true,
      virtual: true,
    });
  }
  nextFiles.sort((left, right) => left.path.localeCompare(right.path));
  return {
    agentId: agent.id,
    companyId: agent.companyId,
    mode: state.mode,
    rootPath: state.rootPath,
    managedRootPath: resolveManagedInstructionsRoot(agent),
    entryFile: state.entryFile,
    resolvedEntryPath: state.resolvedEntryPath,
    editable: Boolean(state.rootPath),
    warnings: state.warnings,
    legacyPromptTemplateActive: state.legacyPromptTemplateActive,
    legacyBootstrapPromptTemplateActive: state.legacyBootstrapPromptTemplateActive,
    files: nextFiles,
  };
}

function applyBundleConfig(
  config: Record<string, unknown>,
  input: {
    mode: BundleMode;
    rootPath: string;
    entryFile: string;
    clearLegacyPromptTemplate?: boolean;
  },
): Record<string, unknown> {
  const next: Record<string, unknown> = {
    ...config,
    [MODE_KEY]: input.mode,
    [ROOT_KEY]: input.rootPath,
    [ENTRY_KEY]: input.entryFile,
    [FILE_KEY]: path.resolve(input.rootPath, input.entryFile),
  };
  if (input.clearLegacyPromptTemplate) {
    delete next[PROMPT_KEY];
    delete next[BOOTSTRAP_PROMPT_KEY];
  }
  return next;
}

function buildPersistedBundleConfig(
  derived: BundleState,
  current: BundleState,
  options?: { clearLegacyPromptTemplate?: boolean },
): Record<string, unknown> {
  const currentRootPath = current.rootPath ? path.resolve(current.rootPath) : null;
  const derivedRootPath = derived.rootPath ? path.resolve(derived.rootPath) : null;
  const configMatchesRecoveredState =
    derived.mode === current.mode
    && derivedRootPath !== null
    && currentRootPath !== null
    && derivedRootPath === currentRootPath
    && derived.entryFile === current.entryFile;

  if (configMatchesRecoveredState && !options?.clearLegacyPromptTemplate) {
    return current.config;
  }

  if (!current.rootPath || !current.mode) {
    return current.config;
  }

  return applyBundleConfig(current.config, {
    mode: current.mode,
    rootPath: current.rootPath,
    entryFile: current.entryFile,
    clearLegacyPromptTemplate: options?.clearLegacyPromptTemplate,
  });
}

async function writeBundleFiles(
  rootPath: string,
  files: Record<string, string>,
  options?: { overwriteExisting?: boolean; privateFiles?: boolean },
) {
  for (const [relativePath, content] of Object.entries(files)) {
    const normalizedPath = normalizeRelativeFilePath(relativePath);
    const absolutePath = resolvePathWithinRoot(rootPath, normalizedPath);
    const existingStat = await statIfExists(absolutePath);
    if (existingStat?.isFile() && !options?.overwriteExisting) continue;
    if (options?.privateFiles) {
      await ensurePrivateDirectory(path.dirname(absolutePath));
      await fs.writeFile(absolutePath, content, { encoding: "utf8", mode: 0o600 });
      await fs.chmod(absolutePath, 0o600);
    } else {
      await fs.mkdir(path.dirname(absolutePath), { recursive: true });
      await fs.writeFile(absolutePath, content, "utf8");
    }
  }
}

async function ensurePrivateDirectory(directoryPath: string) {
  await fs.mkdir(directoryPath, { recursive: true, mode: 0o700 });
  await fs.chmod(directoryPath, 0o700);
}

async function hardenManagedBundlePermissions(agent: AgentLike, rootPath: string) {
  if (path.resolve(rootPath) !== resolveManagedInstructionsRoot(agent)) return;
  async function hardenTree(currentPath: string) {
    const currentStat = await fs.lstat(currentPath).catch(() => null);
    if (!currentStat?.isDirectory() || currentStat.isSymbolicLink()) return;
    await fs.chmod(currentPath, 0o700);
    const entries = await fs.readdir(currentPath, { withFileTypes: true });
    for (const entry of entries) {
      const absolutePath = path.join(currentPath, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) {
        await hardenTree(absolutePath);
        continue;
      }
      if (!entry.isFile()) continue;
      const stat = await fs.stat(absolutePath);
      await fs.chmod(absolutePath, (stat.mode & 0o100) === 0o100 ? 0o700 : 0o600);
    }
  }
  await hardenTree(rootPath);
}

export function syncInstructionsBundleConfigFromFilePath(
  agent: AgentLike,
  adapterConfig: Record<string, unknown>,
): Record<string, unknown> {
  const instructionsFilePath = asString(adapterConfig[FILE_KEY]);
  const next = { ...adapterConfig };
  if (!instructionsFilePath) {
    delete next[MODE_KEY];
    delete next[ROOT_KEY];
    delete next[ENTRY_KEY];
    return next;
  }
  const resolvedPath = resolveLegacyInstructionsPath(instructionsFilePath, adapterConfig);
  const rootPath = path.dirname(resolvedPath);
  const entryFile = path.basename(resolvedPath);
  const mode: BundleMode = resolvedPath.startsWith(`${resolveManagedInstructionsRoot(agent)}${path.sep}`)
    || resolvedPath === path.join(resolveManagedInstructionsRoot(agent), entryFile)
    ? "managed"
    : "external";
  return applyBundleConfig(next, { mode, rootPath, entryFile });
}

export function agentInstructionsService(serviceOptions: AgentInstructionsServiceOptions = {}) {
  async function getBundle(agent: AgentLike): Promise<AgentInstructionsBundle> {
    const state = await recoverManagedBundleState(agent, deriveBundleState(agent));
    if (!state.rootPath) return toBundle(agent, state, []);
    const stat = await statIfExists(state.rootPath);
    if (!stat?.isDirectory()) {
      return toBundle(agent, {
        ...state,
        warnings: [...state.warnings, `Instructions root does not exist: ${state.rootPath}`],
      }, []);
    }
    if (state.mode === "managed" && !isHistoricalAgentTombstoneId(agent.id)) {
      await hardenManagedBundlePermissions(agent, state.rootPath);
    }
    const files = await listFilesRecursive(state.rootPath);
    const summaries = await Promise.all(files.map((relativePath) => readFileSummary(state.rootPath!, relativePath, state.entryFile)));
    return toBundle(agent, state, summaries);
  }

  async function readFile(agent: AgentLike, relativePath: string): Promise<AgentInstructionsFileDetail> {
    const state = await recoverManagedBundleState(agent, deriveBundleState(agent));
    if (relativePath === LEGACY_PROMPT_TEMPLATE_PATH) {
      const content = asString(state.config[PROMPT_KEY]);
      if (content === null) throw notFound("Instructions file not found");
      return {
        path: LEGACY_PROMPT_TEMPLATE_PATH,
        size: content.length,
        language: "markdown",
        markdown: true,
        isEntryFile: false,
        editable: true,
        deprecated: true,
        virtual: true,
        content,
      };
    }
    if (!state.rootPath) throw notFound("Agent instructions bundle is not configured");
    const absolutePath = resolvePathWithinRoot(state.rootPath, relativePath);
    const [content, stat] = await Promise.all([
      fs.readFile(absolutePath, "utf8").catch(() => null),
      fs.stat(absolutePath).catch(() => null),
    ]);
    if (content === null || !stat?.isFile()) throw notFound("Instructions file not found");
    const normalizedPath = normalizeRelativeFilePath(relativePath);
    return {
      path: normalizedPath,
      size: stat.size,
      language: inferLanguage(normalizedPath),
      markdown: isMarkdown(normalizedPath),
      isEntryFile: normalizedPath === state.entryFile,
      editable: true,
      deprecated: false,
      virtual: false,
      content,
    };
  }

  async function ensureWritableBundle(
    agent: AgentLike,
    options?: { clearLegacyPromptTemplate?: boolean },
  ): Promise<{ adapterConfig: Record<string, unknown>; state: BundleState }> {
    assertHistoricalAgentTombstoneMutable(agent.id);
    const derived = deriveBundleState(agent);
    const current = await recoverManagedBundleState(agent, derived);
    if (current.rootPath && current.mode) {
      if (current.mode === "external") {
        const adapterConfig = buildPersistedBundleConfig(derived, current, options);
        return {
          adapterConfig,
          state: deriveBundleState({ ...agent, adapterConfig }),
        };
      }
      const canonicalRoot = resolveManagedInstructionsRoot(agent);
      const currentFiles = path.resolve(current.rootPath) === canonicalRoot
        ? await listFilesRecursive(canonicalRoot)
        : [];
      if (path.resolve(current.rootPath) === canonicalRoot && currentFiles.length > 0) {
        await hardenManagedBundlePermissions(agent, current.rootPath);
        const adapterConfig = buildPersistedBundleConfig(derived, current, options);
        return {
          adapterConfig,
          state: deriveBundleState({ ...agent, adapterConfig }),
        };
      }
    }

    const managedRoot = resolveManagedInstructionsRoot(agent);
    const entryFile = current.entryFile || ENTRY_FILE_DEFAULT;
    const nextConfig = applyBundleConfig(current.config, {
      mode: "managed",
      rootPath: managedRoot,
      entryFile,
      clearLegacyPromptTemplate: options?.clearLegacyPromptTemplate,
    });
    await ensurePrivateDirectory(managedRoot);

    const entryPath = resolvePathWithinRoot(managedRoot, entryFile);
    const entryStat = await statIfExists(entryPath);
    if (!entryStat?.isFile()) {
      const legacyInstructions = await readLegacyInstructions(agent, current.config);
      await ensurePrivateDirectory(path.dirname(entryPath));
      await fs.writeFile(entryPath, legacyInstructions, { encoding: "utf8", mode: 0o600 });
      await fs.chmod(entryPath, 0o600);
    }

    return {
      adapterConfig: nextConfig,
      state: deriveBundleState({ ...agent, adapterConfig: nextConfig }),
    };
  }

  async function updateBundle(
    agent: AgentLike,
    input: {
      mode?: BundleMode;
      rootPath?: string | null;
      entryFile?: string;
      clearLegacyPromptTemplate?: boolean;
    },
  ): Promise<{ bundle: AgentInstructionsBundle; adapterConfig: Record<string, unknown> }> {
    assertHistoricalAgentTombstoneMutable(agent.id);
    const state = await recoverManagedBundleState(agent, deriveBundleState(agent));
    const nextMode = input.mode ?? state.mode ?? "managed";
    const nextEntryFile = input.entryFile ? normalizeRelativeFilePath(input.entryFile) : state.entryFile;
    let nextRootPath: string;

    if (nextMode === "managed") {
      nextRootPath = resolveManagedInstructionsRoot(agent);
    } else {
      const rootPath = asString(input.rootPath) ?? state.rootPath;
      if (!rootPath) {
        throw unprocessable("External instructions bundles require an absolute rootPath");
      }
      const resolvedRoot = resolveHomeAwarePath(rootPath);
      if (!path.isAbsolute(resolvedRoot)) {
        throw unprocessable("External instructions bundles require an absolute rootPath");
      }
      nextRootPath = resolvedRoot;
    }

    if (nextMode === "managed") await ensurePrivateDirectory(nextRootPath);
    else await fs.mkdir(nextRootPath, { recursive: true });

    const existingFiles = await listFilesRecursive(nextRootPath);
    const exported = await exportFiles(agent);
    if (existingFiles.length === 0) {
      await writeBundleFiles(nextRootPath, exported.files, { privateFiles: nextMode === "managed" });
    }
    const refreshedFiles = existingFiles.length === 0 ? await listFilesRecursive(nextRootPath) : existingFiles;
    if (!refreshedFiles.includes(nextEntryFile)) {
      const nextEntryContent = exported.files[nextEntryFile] ?? exported.files[exported.entryFile] ?? "";
      await writeBundleFiles(nextRootPath, { [nextEntryFile]: nextEntryContent }, {
        privateFiles: nextMode === "managed",
      });
    }

    const nextConfig = applyBundleConfig(state.config, {
      mode: nextMode,
      rootPath: nextRootPath,
      entryFile: nextEntryFile,
      clearLegacyPromptTemplate: input.clearLegacyPromptTemplate,
    });
    const nextBundle = await getBundle({ ...agent, adapterConfig: nextConfig });
    return { bundle: nextBundle, adapterConfig: nextConfig };
  }

  async function writeFile(
    agent: AgentLike,
    relativePath: string,
    content: string,
    options?: { clearLegacyPromptTemplate?: boolean },
  ): Promise<{
    bundle: AgentInstructionsBundle;
    file: AgentInstructionsFileDetail;
    adapterConfig: Record<string, unknown>;
  }> {
    assertHistoricalAgentTombstoneMutable(agent.id);
    const current = deriveBundleState(agent);
    if (relativePath === LEGACY_PROMPT_TEMPLATE_PATH) {
      const adapterConfig: Record<string, unknown> = {
        ...current.config,
        [PROMPT_KEY]: content,
      };
      const nextAgent = { ...agent, adapterConfig };
      const [bundle, file] = await Promise.all([
        getBundle(nextAgent),
        readFile(nextAgent, LEGACY_PROMPT_TEMPLATE_PATH),
      ]);
      return { bundle, file, adapterConfig };
    }

    const prepared = await ensureWritableBundle(agent, options);
    const absolutePath = resolvePathWithinRoot(prepared.state.rootPath!, relativePath);
    if (prepared.state.mode === "managed") {
      await ensurePrivateDirectory(path.dirname(absolutePath));
      await fs.writeFile(absolutePath, content, { encoding: "utf8", mode: 0o600 });
      await fs.chmod(absolutePath, 0o600);
    } else {
      await fs.mkdir(path.dirname(absolutePath), { recursive: true });
      await fs.writeFile(absolutePath, content, "utf8");
    }
    const nextAgent = { ...agent, adapterConfig: prepared.adapterConfig };
    const [bundle, file] = await Promise.all([
      getBundle(nextAgent),
      readFile(nextAgent, relativePath),
    ]);
    return { bundle, file, adapterConfig: prepared.adapterConfig };
  }

  async function deleteFile(agent: AgentLike, relativePath: string): Promise<{
    bundle: AgentInstructionsBundle;
    adapterConfig: Record<string, unknown>;
  }> {
    assertHistoricalAgentTombstoneMutable(agent.id);
    if (relativePath === LEGACY_PROMPT_TEMPLATE_PATH) {
      throw unprocessable("Cannot delete the legacy promptTemplate pseudo-file");
    }
    const prepared = await ensureWritableBundle(agent);
    const state = prepared.state;
    if (!state.rootPath) throw notFound("Agent instructions bundle is not configured");
    const normalizedPath = normalizeRelativeFilePath(relativePath);
    if (normalizedPath === state.entryFile) {
      throw unprocessable("Cannot delete the bundle entry file");
    }
    const absolutePath = resolvePathWithinRoot(state.rootPath, normalizedPath);
    await fs.rm(absolutePath, { force: true });
    const adapterConfig = prepared.adapterConfig;
    const bundle = await getBundle({ ...agent, adapterConfig });
    return { bundle, adapterConfig };
  }

  async function exportFilesInternal(
    agent: AgentLike,
    hardenPermissions: boolean,
    readOnlyOptions?: ResolvedReadOnlyExportOptions,
  ): Promise<{
    files: Record<string, string>;
    entryFile: string;
    warnings: string[];
  }> {
    const listBundleFiles = readOnlyOptions
      ? (rootPath: string) => listFilesRecursiveBounded(rootPath, readOnlyOptions)
      : listFilesRecursive;
    const derivedState = deriveBundleState(agent);
    const state = readOnlyOptions && derivedState.mode === "external"
      ? derivedState
      : await recoverManagedBundleState(
        agent,
        derivedState,
        listBundleFiles,
        Boolean(readOnlyOptions),
      );
    if (state.rootPath) {
      assertReadOnlyExportNotAborted(readOnlyOptions?.signal);
      if (readOnlyOptions) {
        const scan = await scanReadOnlyBundleRoot(state.rootPath, readOnlyOptions);
        if (scan.relativePaths.length === 0) {
          throw new Error("agent_instructions_root_empty");
        }
        const files: Record<string, string> = {};
        let totalBytes = 0;
        for (const relativePath of scan.relativePaths) {
          const read = await secureReadBundleFile(
            scan,
            relativePath,
            readOnlyOptions,
            readOnlyOptions.maxTotalBytes - totalBytes,
            serviceOptions.beforeReadOnlyFileOpen,
          );
          totalBytes += read.bytes;
          files[relativePath] = read.content;
        }
        for (const identity of scan.directories) {
          await assertReadOnlyDirectoryIdentity(scan.canonicalRoot, identity);
        }
        return { files, entryFile: state.entryFile, warnings: state.warnings };
      }
      const stat = await statIfExists(state.rootPath);
      if (stat?.isDirectory()) {
        if (hardenPermissions && state.mode === "managed") {
          await hardenManagedBundlePermissions(agent, state.rootPath);
        }
        const relativePaths = await listBundleFiles(state.rootPath);
        const files: Record<string, string> = {};
        for (const relativePath of relativePaths) {
          const absolutePath = resolvePathWithinRoot(state.rootPath!, relativePath);
          files[relativePath] = await fs.readFile(absolutePath, {
            encoding: "utf8",
          });
        }
        if (Object.keys(files).length > 0) {
          return { files, entryFile: state.entryFile, warnings: state.warnings };
        }
      }
    }

    let legacyBody: string;
    if (readOnlyOptions) {
      assertReadOnlyExportNotAborted(readOnlyOptions.signal);
      const instructionsFilePath = asString(state.config[FILE_KEY]);
      if (instructionsFilePath) {
        // A declared file path is authoritative.  Resolution/read failures do
        // not silently downgrade maintenance evidence to promptTemplate.
        const resolvedPath = resolveLegacyInstructionsPath(instructionsFilePath, state.config);
        const legacyRoot = path.dirname(resolvedPath);
        const scan = await scanReadOnlyBundleRoot(legacyRoot, {
          ...readOnlyOptions,
          maxFiles: Math.max(readOnlyOptions.maxFiles, 1),
        });
        const relativePath = normalizeRelativeFilePath(path.basename(resolvedPath));
        if (!scan.relativePaths.includes(relativePath)) {
          throw new Error("agent_instructions_legacy_file_missing");
        }
        legacyBody = (await secureReadBundleFile(
          scan,
          relativePath,
          readOnlyOptions,
          readOnlyOptions.maxTotalBytes,
          serviceOptions.beforeReadOnlyFileOpen,
        )).content;
      } else {
        legacyBody = asString(state.config[PROMPT_KEY]) ?? "";
      }
      if (Buffer.byteLength(legacyBody, "utf8") > readOnlyOptions.maxTotalBytes) {
        throw new Error("agent_instructions_max_total_bytes_exceeded");
      }
    } else {
      legacyBody = await readLegacyInstructions(agent, state.config);
    }
    return {
      files: { [state.entryFile]: legacyBody || "_No AGENTS instructions were resolved from current agent config._" },
      entryFile: state.entryFile,
      warnings: state.warnings,
    };
  }

  async function exportFiles(agent: AgentLike) {
    if (isHistoricalAgentTombstoneId(agent.id)) return exportFilesReadOnly(agent);
    return exportFilesInternal(agent, true);
  }

  async function exportFilesReadOnly(agent: AgentLike, options: ReadOnlyExportOptions = {}) {
    return exportFilesInternal(agent, false, resolveReadOnlyExportOptions(options));
  }

  async function materializeManagedBundle(
    agent: AgentLike,
    files: Record<string, string>,
    options?: {
      clearLegacyPromptTemplate?: boolean;
      replaceExisting?: boolean;
      entryFile?: string;
    },
  ): Promise<{ bundle: AgentInstructionsBundle; adapterConfig: Record<string, unknown> }> {
    assertHistoricalAgentTombstoneMutable(agent.id);
    const rootPath = resolveManagedInstructionsRoot(agent);
    const entryFile = options?.entryFile ? normalizeRelativeFilePath(options.entryFile) : ENTRY_FILE_DEFAULT;

    if (options?.replaceExisting) {
      await fs.rm(rootPath, { recursive: true, force: true });
    }
    await ensurePrivateDirectory(rootPath);

    const normalizedEntries = Object.entries(files).map(([relativePath, content]) => [
      normalizeRelativeFilePath(relativePath),
      content,
    ] as const);
    for (const [relativePath, content] of normalizedEntries) {
      const absolutePath = resolvePathWithinRoot(rootPath, relativePath);
      await ensurePrivateDirectory(path.dirname(absolutePath));
      await fs.writeFile(absolutePath, content, { encoding: "utf8", mode: 0o600 });
      await fs.chmod(absolutePath, 0o600);
    }
    if (!normalizedEntries.some(([relativePath]) => relativePath === entryFile)) {
      const entryPath = resolvePathWithinRoot(rootPath, entryFile);
      await ensurePrivateDirectory(path.dirname(entryPath));
      await fs.writeFile(entryPath, "", { encoding: "utf8", mode: 0o600 });
      await fs.chmod(entryPath, 0o600);
    }

    const adapterConfig = applyBundleConfig(asRecord(agent.adapterConfig), {
      mode: "managed",
      rootPath,
      entryFile,
      clearLegacyPromptTemplate: options?.clearLegacyPromptTemplate,
    });
    const bundle = await getBundle({ ...agent, adapterConfig });
    return { bundle, adapterConfig };
  }

  return {
    getBundle,
    readFile,
    updateBundle,
    writeFile,
    deleteFile,
    exportFiles,
    exportFilesReadOnly,
    ensureManagedBundle: ensureWritableBundle,
    materializeManagedBundle,
  };
}

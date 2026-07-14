import { constants as fsConstants } from "node:fs";
import { createHash } from "node:crypto";
import { lstat, open, realpath, type FileHandle } from "node:fs/promises";
import path from "node:path";

const MAX_PROJECT_BYTES = 1024 * 1024;
const EXPECTED_REPLACEMENT_REF = "workspace:projects/kaffee";
const EXPECTED_OBSERVED_REF = "workspace:projects/kaffee:PROJECT.md";

type FileIdentity = {
  dev: string;
  ino: string;
  mode: number;
  nlink: number;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
};

function identity(stat: Awaited<ReturnType<FileHandle["stat"]>>): FileIdentity {
  return {
    dev: String(stat.dev),
    ino: String(stat.ino),
    mode: Number(stat.mode) & 0o777,
    nlink: Number(stat.nlink),
    size: Number(stat.size),
    mtimeMs: Number(stat.mtimeMs),
    ctimeMs: Number(stat.ctimeMs),
  };
}

function sameIdentity(left: FileIdentity, right: FileIdentity) {
  return left.dev === right.dev
    && left.ino === right.ino
    && left.mode === right.mode
    && left.nlink === right.nlink
    && left.size === right.size
    && left.mtimeMs === right.mtimeMs
    && left.ctimeMs === right.ctimeMs;
}

export async function verifyRetirementSystemReplacementArtifact(input: {
  replacementSystemRef: string;
  observedRef: unknown;
  observedSha256: unknown;
  workspaceRoot: string;
}) {
  if (
    input.replacementSystemRef !== EXPECTED_REPLACEMENT_REF
    || input.observedRef !== EXPECTED_OBSERVED_REF
    || typeof input.observedSha256 !== "string"
    || !/^[a-f0-9]{64}$/.test(input.observedSha256)
  ) throw new Error("system replacement receipt is not canonical");

  const requestedRoot = path.resolve(input.workspaceRoot);
  const rootBeforeStat = await lstat(requestedRoot);
  if (rootBeforeStat.isSymbolicLink() || !rootBeforeStat.isDirectory()) {
    throw new Error("workspace root is not an exact directory");
  }
  const canonicalRoot = await realpath(requestedRoot);
  const parentPath = path.join(requestedRoot, "projects/kaffee");
  const parentBeforeStat = await lstat(parentPath);
  if (parentBeforeStat.isSymbolicLink() || !parentBeforeStat.isDirectory()) {
    throw new Error("replacement project directory is not exact");
  }
  const canonicalParent = await realpath(parentPath);
  if (path.relative(canonicalRoot, canonicalParent).startsWith("..")) {
    throw new Error("replacement project escaped the workspace root");
  }
  const target = path.join(parentPath, "PROJECT.md");
  const canonicalTarget = await realpath(target);
  if (path.relative(canonicalRoot, canonicalTarget).startsWith("..")) {
    throw new Error("replacement project file escaped the workspace root");
  }
  const beforeStat = await lstat(target);
  const before = identity(beforeStat as Awaited<ReturnType<FileHandle["stat"]>>);
  if (
    beforeStat.isSymbolicLink()
    || !beforeStat.isFile()
    || before.nlink !== 1
    || before.size <= 0
    || before.size > MAX_PROJECT_BYTES
  ) throw new Error("replacement project file is not a bounded one-link regular file");

  const handle = await open(target, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const opened = identity(await handle.stat());
    if (!sameIdentity(before, opened)) throw new Error("replacement project changed while opening");
    const digest = createHash("sha256");
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const raw of handle.createReadStream({ autoClose: false, start: 0 })) {
      const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
      size += chunk.length;
      if (size > MAX_PROJECT_BYTES) throw new Error("replacement project exceeded its bound");
      digest.update(chunk);
      chunks.push(chunk);
    }
    const content = Buffer.concat(chunks).toString("utf8");
    const openedAfter = identity(await handle.stat());
    const pathAfter = identity(await lstat(target) as Awaited<ReturnType<FileHandle["stat"]>>);
    if (
      size !== opened.size
      || !sameIdentity(opened, openedAfter)
      || !sameIdentity(opened, pathAfter)
      || await realpath(target) !== canonicalTarget
      || await realpath(parentPath) !== canonicalParent
      || await realpath(requestedRoot) !== canonicalRoot
    ) throw new Error("replacement project changed while streaming");
    if (digest.digest("hex") !== input.observedSha256) {
      throw new Error("replacement project hash drifted from its canary");
    }
    if (
      !/^---\n[\s\S]*?^slug:\s*["']?kaffee["']?\s*$[\s\S]*?^status:\s*["']?active["']?\s*$[\s\S]*?^code_path:\s*~\/Code\/kaffee\s*$[\s\S]*?^---$/m.test(content)
      || !/^# Kaffee$/m.test(content)
    ) throw new Error("replacement project contract is not operationally identifiable");
  } finally {
    await handle.close();
  }
}

import { constants as fsConstants } from "node:fs";
import { lstat, open, realpath, type FileHandle } from "node:fs/promises";
import { createHash } from "node:crypto";
import { Transform } from "node:stream";
import { StringDecoder } from "node:string_decoder";
import { createGunzip } from "node:zlib";
import path from "node:path";
import {
  type AgentRetirementEvidence,
} from "@paperclipai/shared";
import {
  RETIREMENT_RESTORE_CANONICAL_AGENT_PARTITION,
  RETIREMENT_RESTORE_REQUIRED_TABLES,
  assertRetirementRestoreInventory,
  createRetirementSqlInventoryCollector,
  type RetirementRestoreAgentPartition,
  type RetirementRestoreInventoryProof,
} from "./agent-retirement-restore-inventory.js";
const MAX_JSON_BYTES = 8 * 1024 * 1024;
const MAX_KEY_BYTES = 4 * 1024;
const MAX_SQL_COMPRESSED_BYTES = 128 * 1024 * 1024;
const MAX_SQL_DECOMPRESSED_BYTES = 1024 * 1024 * 1024;
const MAX_SQL_LINES = 500_000;

type UnknownRecord = Record<string, unknown>;
export type RetirementArtifactVerificationOptions = {
  backupRoot: string;
  retirementEvidenceRoot: string;
  now: Date;
  maxAgeMs: number;
  futureSkewMs: number;
  onArtifactOpened?: (kind: string, artifactPath: string) => void | Promise<void>;
};
type VerificationOptions = RetirementArtifactVerificationOptions & {
  claimedReceiptRevalidation?: boolean;
};

type FileIdentity = {
  dev: string;
  ino: string;
  mode: number;
  nlink: number;
  size: number;
  mtimeMs: number;
  ctimeMs: number;
};

export type RetirementArtifactIdentityReceipt = {
  schemaVersion: "1.0.0";
  kind: string;
  artifactPath: string;
  rootPath: string;
  parentPath: string;
  rootIdentity: FileIdentity;
  parentIdentity: FileIdentity;
  openedIdentity: FileIdentity;
  sha256: string;
  sizeBytes: number;
  receiptId: string;
};

export type RetirementSourceArtifactReceipt = {
  schemaVersion: "1.0.0";
  kind: "retirement_source_artifact";
  sourceAgentId: string;
  companyId: string;
  sourceName: string;
  expectedUpdatedAt: string;
  descriptor: AgentRetirementEvidence["sourceExport"];
  identity: RetirementArtifactIdentityReceipt;
  receiptId: string;
};

export type RetirementCommonArtifactReceipt = {
  schemaVersion: "1.0.0";
  kind: "retirement_common_artifacts";
  binding: AgentRetirementEvidence["backupRestore"];
  artifacts: {
    dump: RetirementArtifactIdentityReceipt;
    masterKey: RetirementArtifactIdentityReceipt;
    restoreEvidence: RetirementArtifactIdentityReceipt;
  };
  inventory: {
    tableCount: number;
    tableNamesSha256: string;
    copiedTableCount: number;
    copiedTableNamesSha256: string;
    retirementInventory: RetirementRestoreInventoryProof;
  };
  restoredStateSha256: string;
  commonArtifactFingerprint: string;
  verificationMode: "streaming_sql_row_binding";
  receiptId: string;
};

function asRecord(value: unknown): UnknownRecord {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as UnknownRecord
    : {};
}

function stableNormalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableNormalize);
  if (!value || typeof value !== "object") return value;
  const record = value as UnknownRecord;
  return Object.fromEntries(Object.keys(record).sort().map((key) => [key, stableNormalize(record[key])]));
}

function sha256(value: Buffer | string) {
  return createHash("sha256").update(value).digest("hex");
}

function stableSha256(value: unknown) {
  return sha256(JSON.stringify(stableNormalize(value)));
}

function fingerprint(value: unknown) {
  return `v1:sha256:${stableSha256(value)}`;
}

function identity(stat: Awaited<ReturnType<FileHandle["stat"]>>): FileIdentity {
  const numeric = (value: number | bigint) => Number(value);
  return {
    dev: String(stat.dev),
    ino: String(stat.ino),
    mode: numeric(stat.mode) & 0o777,
    nlink: numeric(stat.nlink),
    size: numeric(stat.size),
    mtimeMs: numeric(stat.mtimeMs),
    ctimeMs: numeric(stat.ctimeMs),
  };
}

function sameIdentity(left: FileIdentity, right: FileIdentity) {
  return left.dev === right.dev && left.ino === right.ino && left.mode === right.mode &&
    left.nlink === right.nlink && left.size === right.size && left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs;
}

function assertFresh(capturedAt: string, options: VerificationOptions) {
  const timestamp = Date.parse(capturedAt);
  if (
    !Number.isFinite(timestamp)
    || timestamp > options.now.getTime() + options.futureSkewMs
    || (!options.claimedReceiptRevalidation && options.now.getTime() - timestamp > options.maxAgeMs)
  ) throw new Error("artifact timestamp is not fresh");
}

async function openExactDirectory(directoryPath: string) {
  const requested = path.resolve(directoryPath);
  const beforeStat = await lstat(requested);
  if (beforeStat.isSymbolicLink() || !beforeStat.isDirectory()) {
    throw new Error("artifact directory is not an exact directory");
  }
  const absolute = await realpath(requested);
  const handle = await open(
    requested,
    fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | (fsConstants.O_DIRECTORY ?? 0),
  );
  const before = identity(beforeStat as Awaited<ReturnType<FileHandle["stat"]>>);
  const opened = identity(await handle.stat());
  if (!sameIdentity(before, opened)) {
    await handle.close();
    throw new Error("artifact directory changed while opening");
  }
  if (await realpath(requested) !== absolute) {
    await handle.close();
    throw new Error("artifact directory changed while opening");
  }
  return { absolute, requested, handle, opened };
}

async function assertDirectoryUnchanged(
  directory: Awaited<ReturnType<typeof openExactDirectory>>,
) {
  const openedAfter = identity(await directory.handle.stat());
  const pathAfter = identity(await lstat(directory.requested) as Awaited<ReturnType<FileHandle["stat"]>>);
  if (
    !sameIdentity(directory.opened, openedAfter)
    || !sameIdentity(directory.opened, pathAfter)
    || await realpath(directory.requested) !== directory.absolute
  ) throw new Error("artifact directory changed while reading");
}

async function streamBounded(handle: FileHandle, maxBytes: number) {
  const digest = createHash("sha256");
  const chunks: Buffer[] = [];
  let sizeBytes = 0;
  for await (const raw of handle.createReadStream({ autoClose: false, start: 0 })) {
    const chunk = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
    sizeBytes += chunk.length;
    if (sizeBytes > maxBytes) throw new Error("artifact exceeds size limit");
    digest.update(chunk);
    chunks.push(chunk);
  }
  return { bytes: Buffer.concat(chunks), sha256: digest.digest("hex"), sizeBytes };
}

async function streamSqlInventory(
  handle: FileHandle,
  partition: RetirementRestoreAgentPartition,
) {
  const compressedHash = createHash("sha256");
  let compressedSize = 0;
  const hashing = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      compressedHash.update(bytes);
      compressedSize += bytes.length;
      if (compressedSize > MAX_SQL_COMPRESSED_BYTES) {
        callback(new Error("compressed database dump exceeds the fixed byte bound"));
        return;
      }
      callback(null, bytes);
    },
  });
  const gunzip = createGunzip();
  const decoder = new StringDecoder("utf8");
  const collector = createRetirementSqlInventoryCollector(partition);
  let pending = "";
  let decompressedSize = 0;
  let lineCount = 0;
  const scan = (text: string) => {
    pending += text;
    for (;;) {
      const newline = pending.indexOf("\n");
      if (newline < 0) break;
      lineCount += 1;
      if (lineCount > MAX_SQL_LINES) throw new Error("database dump exceeds the fixed line bound");
      collector.pushLine(pending.slice(0, newline));
      pending = pending.slice(newline + 1);
    }
    if (pending.length > 16 * 1024 * 1024) throw new Error("database dump contains an oversized SQL line");
  };
  const output = handle.createReadStream({ autoClose: false, start: 0 }).pipe(hashing).pipe(gunzip);
  for await (const raw of output) {
    const bytes = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
    decompressedSize += bytes.length;
    if (decompressedSize > MAX_SQL_DECOMPRESSED_BYTES) {
      throw new Error("decompressed database dump exceeds the fixed byte bound");
    }
    scan(decoder.write(bytes));
  }
  scan(decoder.end());
  if (pending.length > 0) {
    lineCount += 1;
    if (lineCount > MAX_SQL_LINES) throw new Error("database dump exceeds the fixed line bound");
    collector.pushLine(pending);
  }
  const inspected = collector.finish();
  return {
    sha256: compressedHash.digest("hex"),
    sizeBytes: compressedSize,
    created: inspected.created,
    copied: inspected.copied,
    retirementInventory: inspected.retirementInventory,
  };
}

async function consumePrivateArtifact<T>(input: {
  kind: string;
  artifactPath: string;
  root: string;
  expectedSha256: string;
  expectedSize: number;
  capturedAt: string;
  maxBytes?: number;
  consume: (handle: FileHandle) => Promise<T & { sha256: string; sizeBytes: number }>;
}, options: VerificationOptions): Promise<T & {
  sha256: string;
  sizeBytes: number;
  identityReceipt: RetirementArtifactIdentityReceipt;
}> {
  if (!path.isAbsolute(input.artifactPath)) throw new Error("artifact path is not absolute");
  assertFresh(input.capturedAt, options);
  const root = await openExactDirectory(input.root);
  const requestedArtifactPath = path.resolve(input.artifactPath);
  const parentPath = path.dirname(requestedArtifactPath);
  let parent: Awaited<ReturnType<typeof openExactDirectory>> | null = null;
  let handle: FileHandle | null = null;
  try {
    parent = await openExactDirectory(parentPath);
    const artifactPath = await realpath(requestedArtifactPath);
    if (artifactPath === root.absolute) throw new Error("artifact path is not a file below its root");
    const relative = path.relative(root.absolute, artifactPath);
    if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) {
      throw new Error("artifact is outside its allowed root");
    }
    const beforeStat = await lstat(requestedArtifactPath);
    const before = identity(beforeStat as Awaited<ReturnType<FileHandle["stat"]>>);
    if (beforeStat.isSymbolicLink() || !beforeStat.isFile() || before.mode !== 0o600 || before.nlink !== 1) {
      throw new Error("artifact must be one-link regular 0600 file");
    }
    if (before.size <= 0 || before.size !== input.expectedSize) throw new Error("artifact size mismatch");
    if (input.maxBytes !== undefined && before.size > input.maxBytes) throw new Error("artifact exceeds size limit");
    if (Math.abs(before.mtimeMs - Date.parse(input.capturedAt)) > 1) throw new Error("artifact mtime mismatch");

    handle = await open(requestedArtifactPath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const opened = identity(await handle.stat());
    if (!sameIdentity(before, opened) || opened.nlink !== 1) throw new Error("artifact changed while opening");
    await options.onArtifactOpened?.(input.kind, requestedArtifactPath);
    const result = await input.consume(handle);
    if (result.sizeBytes !== input.expectedSize || result.sha256 !== input.expectedSha256) {
      throw new Error("artifact content does not match evidence");
    }
    const openedAfter = identity(await handle.stat());
    const pathAfter = identity(await lstat(requestedArtifactPath) as Awaited<ReturnType<FileHandle["stat"]>>);
    if (
      !sameIdentity(opened, openedAfter)
      || !sameIdentity(opened, pathAfter)
      || openedAfter.nlink !== 1
      || await realpath(requestedArtifactPath) !== artifactPath
    ) throw new Error("artifact changed while streaming");
    await assertDirectoryUnchanged(parent);
    await assertDirectoryUnchanged(root);
    const receiptCore = {
      schemaVersion: "1.0.0" as const,
      kind: input.kind,
      artifactPath: requestedArtifactPath,
      rootPath: root.absolute,
      parentPath: parent.absolute,
      rootIdentity: root.opened,
      parentIdentity: parent.opened,
      openedIdentity: opened,
      sha256: result.sha256,
      sizeBytes: result.sizeBytes,
    };
    return {
      ...result,
      identityReceipt: { ...receiptCore, receiptId: fingerprint(receiptCore) },
    };
  } finally {
    await handle?.close();
    await parent?.handle.close();
    await root.handle.close();
  }
}

function parseJson(bytes: Buffer) {
  try {
    const value = JSON.parse(bytes.toString("utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
    return value as UnknownRecord;
  } catch {
    throw new Error("artifact is not valid JSON");
  }
}

function decodeMasterKey(bytes: Buffer) {
  const text = bytes.toString("utf8").trim();
  if (/^[a-fA-F0-9]{64}$/.test(text)) return Buffer.from(text, "hex");
  if (/^[A-Za-z0-9+/]{43}=$/.test(text)) return Buffer.from(text, "base64");
  if (bytes.length === 32) return bytes;
  throw new Error("master key backup is not exactly 32 bytes");
}

function sourceReceiptCore(receipt: RetirementSourceArtifactReceipt) {
  const { receiptId: _receiptId, ...core } = receipt;
  return core;
}

function commonReceiptCore(receipt: RetirementCommonArtifactReceipt) {
  const { receiptId: _receiptId, ...core } = receipt;
  return core;
}

function historicalIdentityBinding(receipt: RetirementArtifactIdentityReceipt) {
  const stableDirectoryIdentity = (value: FileIdentity) => ({
    dev: value.dev,
    ino: value.ino,
    mode: value.mode,
  });
  return {
    schemaVersion: receipt.schemaVersion,
    kind: receipt.kind,
    artifactPath: receipt.artifactPath,
    rootPath: receipt.rootPath,
    parentPath: receipt.parentPath,
    rootIdentity: stableDirectoryIdentity(receipt.rootIdentity),
    parentIdentity: stableDirectoryIdentity(receipt.parentIdentity),
    openedIdentity: receipt.openedIdentity,
    sha256: receipt.sha256,
    sizeBytes: receipt.sizeBytes,
  };
}

function historicalSourceBinding(receipt: RetirementSourceArtifactReceipt) {
  return {
    schemaVersion: receipt.schemaVersion,
    kind: receipt.kind,
    sourceAgentId: receipt.sourceAgentId,
    companyId: receipt.companyId,
    sourceName: receipt.sourceName,
    expectedUpdatedAt: receipt.expectedUpdatedAt,
    descriptor: receipt.descriptor,
    identity: historicalIdentityBinding(receipt.identity),
  };
}

function historicalCommonBinding(receipt: RetirementCommonArtifactReceipt) {
  return {
    schemaVersion: receipt.schemaVersion,
    kind: receipt.kind,
    binding: receipt.binding,
    artifacts: {
      dump: historicalIdentityBinding(receipt.artifacts.dump),
      masterKey: historicalIdentityBinding(receipt.artifacts.masterKey),
      restoreEvidence: historicalIdentityBinding(receipt.artifacts.restoreEvidence),
    },
    inventory: receipt.inventory,
    restoredStateSha256: receipt.restoredStateSha256,
    commonArtifactFingerprint: receipt.commonArtifactFingerprint,
    verificationMode: receipt.verificationMode,
  };
}

export async function verifyRetirementSourceExport(
  evidence: AgentRetirementEvidence,
  expected: { sourceId: string; companyId: string; sourceName: string; expectedUpdatedAt: string },
  options: VerificationOptions,
): Promise<RetirementSourceArtifactReceipt> {
  const descriptor = evidence.sourceExport;
  const streamed = await consumePrivateArtifact({
    kind: "source_export",
    artifactPath: descriptor.path,
    root: options.retirementEvidenceRoot,
    expectedSha256: descriptor.sha256,
    expectedSize: descriptor.sizeBytes,
    capturedAt: descriptor.capturedAt,
    maxBytes: MAX_JSON_BYTES,
    consume: (handle) => streamBounded(handle, MAX_JSON_BYTES),
  }, options);
  const payload = parseJson(streamed.bytes);
  if (
    payload.schemaVersion !== "1.0.0"
    || payload.sourceAgentId !== expected.sourceId
    || payload.companyId !== expected.companyId
    || payload.sourceName !== expected.sourceName
    || payload.expectedUpdatedAt !== expected.expectedUpdatedAt
    || payload.capturedAt !== descriptor.capturedAt
  ) throw new Error("source export is not bound to the described source state");
  const core = {
    schemaVersion: "1.0.0" as const,
    kind: "retirement_source_artifact" as const,
    sourceAgentId: expected.sourceId,
    companyId: expected.companyId,
    sourceName: expected.sourceName,
    expectedUpdatedAt: expected.expectedUpdatedAt,
    descriptor,
    identity: streamed.identityReceipt,
  };
  return { ...core, receiptId: fingerprint(core) };
}

export function assertRetirementSourceArtifactReceipt(
  evidence: AgentRetirementEvidence,
  expected: { sourceId: string; companyId: string; sourceName: string; expectedUpdatedAt: string },
  raw: unknown,
) {
  const receipt = raw as RetirementSourceArtifactReceipt;
  if (
    receipt?.schemaVersion !== "1.0.0"
    || receipt.kind !== "retirement_source_artifact"
    || receipt.sourceAgentId !== expected.sourceId
    || receipt.companyId !== expected.companyId
    || receipt.sourceName !== expected.sourceName
    || receipt.expectedUpdatedAt !== expected.expectedUpdatedAt
    || stableSha256(receipt.descriptor) !== stableSha256(evidence.sourceExport)
    || receipt.receiptId !== fingerprint(sourceReceiptCore(receipt))
  ) throw new Error("stored source artifact receipt is not exact");
  return receipt;
}

export async function verifyRetirementBackupRestore(
  evidence: AgentRetirementEvidence,
  options: VerificationOptions,
): Promise<RetirementCommonArtifactReceipt> {
  const descriptor = evidence.backupRestore;
  const masterAt = Date.parse(descriptor.masterKeyCapturedAt);
  const dumpAt = Date.parse(descriptor.dumpCapturedAt);
  const restoreAt = Date.parse(descriptor.restoreVerifiedAt);
  if (masterAt > dumpAt || dumpAt > restoreAt) {
    throw new Error("backup and restore artifact timestamps are out of order");
  }
  const master = await consumePrivateArtifact({
    kind: "master_key_backup",
    artifactPath: descriptor.masterKeyBackupPath,
    root: options.backupRoot,
    expectedSha256: descriptor.masterKeyBackupSha256,
    expectedSize: descriptor.masterKeyBackupSizeBytes,
    capturedAt: descriptor.masterKeyCapturedAt,
    maxBytes: MAX_KEY_BYTES,
    consume: (handle) => streamBounded(handle, MAX_KEY_BYTES),
  }, options);
  let decodedMasterKey: Buffer | null = null;
  try {
    const restore = await consumePrivateArtifact({
    kind: "restore_evidence",
    artifactPath: descriptor.restoreEvidencePath,
    root: options.retirementEvidenceRoot,
    expectedSha256: descriptor.restoreEvidenceSha256,
    expectedSize: descriptor.restoreEvidenceSizeBytes,
    capturedAt: descriptor.restoreVerifiedAt,
    maxBytes: MAX_JSON_BYTES,
      consume: (handle) => streamBounded(handle, MAX_JSON_BYTES),
    }, options);
    const receipt = parseJson(restore.bytes);
    const backup = asRecord(receipt.backup);
    const keyBackup = asRecord(receipt.masterKeyBackup);
    const prestate = asRecord(receipt.reviewedPrestate);
    const scratch = asRecord(receipt.scratchRestore);
    const partition = RETIREMENT_RESTORE_CANONICAL_AGENT_PARTITION;
    const retirementInventory = assertRetirementRestoreInventory(
      scratch.retirementInventory,
      partition,
    );
    const dump = await consumePrivateArtifact({
      kind: "database_dump",
      artifactPath: descriptor.dumpPath,
      root: options.backupRoot,
      expectedSha256: descriptor.dumpSha256,
      expectedSize: descriptor.dumpSizeBytes,
      capturedAt: descriptor.dumpCapturedAt,
      consume: (handle) => streamSqlInventory(handle, partition),
      maxBytes: MAX_SQL_COMPRESSED_BYTES,
    }, options);
    for (const table of RETIREMENT_RESTORE_REQUIRED_TABLES) {
      if (!dump.created.includes(table) || !dump.copied.includes(table)) {
        throw new Error(`database dump is missing ${table}`);
      }
    }
    decodedMasterKey = decodeMasterKey(master.bytes);
    const keyFingerprint = sha256(decodedMasterKey);
    if (keyFingerprint !== descriptor.masterKeyFingerprintSha256) {
      throw new Error("master key fingerprint mismatch");
    }

    if (
      receipt.schemaVersion !== "1.0.0"
      || receipt.strategy !== "database_restore"
      || receipt.issue !== "TEC-355"
      || receipt.restoreVerified !== true
      || backup.path !== descriptor.dumpPath
      || backup.sha256 !== descriptor.dumpSha256
      || backup.capturedAt !== descriptor.dumpCapturedAt
      || keyBackup.path !== descriptor.masterKeyBackupPath
      || keyBackup.sha256 !== descriptor.masterKeyBackupSha256
      || keyBackup.fingerprintSha256 !== keyFingerprint
      || keyBackup.capturedAt !== descriptor.masterKeyCapturedAt
      || scratch.verifiedAt !== descriptor.restoreVerifiedAt
      || scratch.masterKeyFingerprintSha256 !== keyFingerprint
      || scratch.tableCount !== dump.created.length
      || scratch.copiedTableCount !== dump.copied.length
      || scratch.tableNamesSha256 !== stableSha256(dump.created)
      || scratch.copiedTableNamesSha256 !== stableSha256(dump.copied)
      || retirementInventory.inventorySha256 !== dump.retirementInventory.inventorySha256
      || stableSha256(retirementInventory) !== stableSha256(dump.retirementInventory)
      || scratch.retainedAgentCount !== retirementInventory.retainedAgents.count
      || prestate.retainedAgentCount !== retirementInventory.retainedAgents.count
      || scratch.historicalTombstoneCount !== retirementInventory.historicalTombstones.count
      || scratch.companyCount !== retirementInventory.companies.count
      || scratch.lifecycleContractCount !== retirementInventory.lifecycleContractAgents.count
      || scratch.secretCount !== retirementInventory.companySecrets.count
      || scratch.secretVersionCount !== retirementInventory.companySecretVersions.count
      || scratch.secretBindingCount !== retirementInventory.companySecretBindings.count
    ) throw new Error("restore receipt is not bound to the streamed dump and master key");

    const state = {
      reviewedPrestateSha256: prestate.sha256,
      companyCount: scratch.companyCount,
      retainedAgentCount: scratch.retainedAgentCount,
      historicalTombstoneCount: scratch.historicalTombstoneCount,
      lifecycleContractCount: scratch.lifecycleContractCount,
      tableCount: scratch.tableCount,
      tableNamesSha256: scratch.tableNamesSha256,
      copiedTableCount: scratch.copiedTableCount,
      copiedTableNamesSha256: scratch.copiedTableNamesSha256,
      secretCount: scratch.secretCount,
      secretVersionCount: scratch.secretVersionCount,
      secretBindingCount: scratch.secretBindingCount,
      localEncryptedSecretCount: scratch.localEncryptedSecretCount,
      localEncryptedVersionCount: scratch.localEncryptedVersionCount,
      localEncryptedVersionProofCount: scratch.localEncryptedVersionProofCount,
      localEncryptedVersionProofSha256: scratch.localEncryptedVersionProofSha256,
      retirementInventory,
      masterKeyFingerprintSha256: scratch.masterKeyFingerprintSha256,
    };
    const restoredStateSha256 = stableSha256(state);
    if (scratch.stateSha256 !== restoredStateSha256 || descriptor.restoreStateSha256 !== restoredStateSha256) {
      throw new Error("restore state fingerprint mismatch");
    }
    const inventory = {
      tableCount: dump.created.length,
      tableNamesSha256: stableSha256(dump.created),
      copiedTableCount: dump.copied.length,
      copiedTableNamesSha256: stableSha256(dump.copied),
      retirementInventory: dump.retirementInventory,
    };
    const commonArtifactFingerprint = fingerprint({
      schemaVersion: "1.0.0",
      binding: descriptor,
      inventory,
      restoredStateSha256,
    });
    const core = {
      schemaVersion: "1.0.0" as const,
      kind: "retirement_common_artifacts" as const,
      binding: descriptor,
      artifacts: {
        dump: dump.identityReceipt,
        masterKey: master.identityReceipt,
        restoreEvidence: restore.identityReceipt,
      },
      inventory,
      restoredStateSha256,
      commonArtifactFingerprint,
      verificationMode: "streaming_sql_row_binding" as const,
    };
    return { ...core, receiptId: fingerprint(core) };
  } finally {
    decodedMasterKey?.fill(0);
    master.bytes.fill(0);
  }
}

export function assertRetirementCommonArtifactReceipt(
  evidence: AgentRetirementEvidence,
  raw: unknown,
) {
  const receipt = raw as RetirementCommonArtifactReceipt;
  const partition = RETIREMENT_RESTORE_CANONICAL_AGENT_PARTITION;
  if (
    receipt?.schemaVersion !== "1.0.0"
    || receipt.kind !== "retirement_common_artifacts"
    || receipt.verificationMode !== "streaming_sql_row_binding"
    || assertRetirementRestoreInventory(
      receipt.inventory?.retirementInventory,
      partition,
    ).inventorySha256 !== receipt.inventory.retirementInventory.inventorySha256
    || stableSha256(receipt.binding) !== stableSha256(evidence.backupRestore)
    || receipt.commonArtifactFingerprint !== fingerprint({
      schemaVersion: "1.0.0",
      binding: receipt.binding,
      inventory: receipt.inventory,
      restoredStateSha256: receipt.restoredStateSha256,
    })
    || receipt.receiptId !== fingerprint(commonReceiptCore(receipt))
  ) throw new Error("stored common artifact receipt is not exact");
  return receipt;
}

export async function revalidateRetirementSourceArtifactReceipt(
  evidence: AgentRetirementEvidence,
  expected: { sourceId: string; companyId: string; sourceName: string; expectedUpdatedAt: string },
  rawReceipt: unknown,
  options: RetirementArtifactVerificationOptions,
) {
  const stored = assertRetirementSourceArtifactReceipt(evidence, expected, rawReceipt);
  const fresh = await verifyRetirementSourceExport(evidence, expected, {
    ...options,
    claimedReceiptRevalidation: true,
  });
  if (stableSha256(historicalSourceBinding(fresh)) !== stableSha256(historicalSourceBinding(stored))) {
    throw new Error("claimed source artifact physical identity changed after preflight");
  }
  return stored;
}

export async function revalidateRetirementCommonArtifactReceipt(
  evidence: AgentRetirementEvidence,
  rawReceipt: unknown,
  options: RetirementArtifactVerificationOptions,
) {
  const stored = assertRetirementCommonArtifactReceipt(evidence, rawReceipt);
  const fresh = await verifyRetirementBackupRestore(evidence, {
    ...options,
    claimedReceiptRevalidation: true,
  });
  if (stableSha256(historicalCommonBinding(fresh)) !== stableSha256(historicalCommonBinding(stored))) {
    throw new Error("claimed common artifact physical identity changed after preflight");
  }
  return stored;
}

export async function revalidateRetirementClaimArtifacts(
  evidence: AgentRetirementEvidence,
  expected: { sourceId: string; companyId: string; sourceName: string; expectedUpdatedAt: string },
  claimed: {
    sourceArtifactReceipt: unknown;
    commonArtifactReceipt: unknown;
  },
  options: RetirementArtifactVerificationOptions,
) {
  const sourceArtifactReceipt = await revalidateRetirementSourceArtifactReceipt(
    evidence,
    expected,
    claimed.sourceArtifactReceipt,
    options,
  );
  const commonArtifactReceipt = await revalidateRetirementCommonArtifactReceipt(
    evidence,
    claimed.commonArtifactReceipt,
    options,
  );
  return { sourceArtifactReceipt, commonArtifactReceipt };
}
